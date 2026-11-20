# 两步验证进不去：找回与重置

> 适用于 yuha.studio（`qa-music` 命名空间）。账号主人通过了 Google 登录，但两步验证这一步过不去。

## 先分清是哪一种

页面上的提示说明了服务器那边发生了什么：

| 页面显示 | 含义 | 怎么办 |
| --- | --- | --- |
| 「验证码不匹配」 | 服务器读到了验证码，但对不上 | 输入验证器里**当前**的 6 位数；或者用一个恢复码。连续错 5 次会锁 15 分钟，等一等再试 |
| 「登录没能完成」 | 两步验证的那一步超过 5 分钟没完成 | 回到登录页，从 Google 登录重新开始 |
| 「出了点问题」+ 问题编号 | 服务器出错了，验证码根本没被检查 | 先查日志（下面），不要反复试 |

查「出了点问题」对应的日志：

```bash
kubectl -n qa-music logs deploy/yuha-api --since=6h | grep '<问题编号>'
kubectl -n qa-music logs deploy/yuha-api --since=6h | grep mfa_secret_unreadable
```

出现 `mfa_secret_unreadable`，说明数据库里的验证器密钥解不开：API 现在拿到的 `MFA_ENCRYPTION_SECRET`
（没设时退回 `GOOGLE_SESSION_SECRET`）不是当初加密用的那个。**这会影响每一个开了两步验证的账号**，
所以先把密钥恢复成原来的值，而不是逐个重置账号。在密钥恢复之前，恢复码仍然能用：它只比对哈希，不需要密钥。

## 重置一个账号的两步验证

用于验证器丢了、恢复码也没有或都用完了的情况。执行后，这个账号只用 Google 就能登录，然后可以重新开启两步验证。

需要能对 `qa-music` 命名空间执行 kubectl。这个 Job 用迁移镜像和 `migration` 服务账号，
因为它们本来就持有数据库凭据，不额外授予任何权限。账号邮箱只在命令行里输入，不写进任何文件。

```bash
image=$(kubectl -n qa-music get job yuha-migrate-1 \
  -o jsonpath='{.spec.template.spec.containers[0].image}')
read -r -p 'account email: ' email
sed -e "s#__MIGRATION_IMAGE__#$image#" -e "s#__EMAIL__#$email#" \
    -e "s#__REASON__#owner locked out of two-step sign-in#" \
    deploy/k8s/qa/mfa-reset.yaml | kubectl -n qa-music apply -f -
kubectl -n qa-music wait --for=condition=complete --timeout=120s job/yuha-mfa-reset \
  || kubectl -n qa-music wait --for=condition=failed --timeout=5s job/yuha-mfa-reset
kubectl -n qa-music logs job/yuha-mfa-reset
kubectl -n qa-music delete job yuha-mfa-reset
```

日志最后一行应当是 `account <id>: second factor removed (…)`。

- 显示 `no live account has that address`：邮箱拼错了，或者账号已被删除。什么都没有改。
- 显示 `has no second factor`：这个账号没有开两步验证。什么都没有改。

`yuha-migrate-1` 是每次部署都会重新创建的迁移 Job，它的镜像就是当前版本，带有 `mfa-reset` 命令。

## 重置之后

1. 用 Google 登录，这次不会再要求验证码。
2. 管理员账号进入后台前会被要求开启两步验证：在「账户设置 → 两步验证」里扫码，
   **扫码前先在验证器里删掉旧的 YUHA 条目**，否则会有两个，分不清哪个是现在的。
3. 恢复码只显示一次。保存在验证器所在手机之外的地方。

每次重置都会在 `audit_logs` 里留一行：`action = 'mfa.reset'`、`actor_role = 'operator'`，
以及原因和被删除的状态（是否已启用、剩几个恢复码、锁定状态）。不会记录密钥或恢复码的哈希。
