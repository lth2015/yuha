// Creates (or tops up) the shared team account and prints its balance.
// Runs inside the api container: node - < team_account.mjs
//   STEP=ensure  sign in OPERATOR_EMAIL and TEAM_EMAIL once, so both rows exist
//   STEP=topup   top TEAM_EMAIL up to TEAM_CREDITS through the admin API, as
//                OPERATOR_EMAIL (deploy_yuha.sh makes it admin only around this)
// Both addresses must pass DEV_LOGIN_ALLOWLIST.
const API = process.env.API ?? 'http://127.0.0.1:4000';
const email = process.env.TEAM_EMAIL;
const operator = process.env.OPERATOR_EMAIL;
const want = Number(process.env.TEAM_CREDITS ?? 50);
const step = process.env.STEP ?? 'topup';
const post = async (path, body, token) => {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const login = (e) => post('/v1/auth/dev-login', { email: e, ageConfirmed: true, termsAccepted: true });
if (!email || !operator) throw new Error('TEAM_EMAIL and OPERATOR_EMAIL are required');
const admin = await login(operator);
const team = await login(email);
if (step === 'ensure') {
  console.log(`accounts ready: ${email}, ${operator}`);
} else {
  let have = team.user.creditsAvailable;
  // the operator grant is capped at 20 units per call, so top up in steps
  while (have < want) {
    const units = Math.min(20, want - have);
    await post(`/v1/admin/users/${team.user.userId}/compensate`, { units, reason: 'shared team account for the internal YUHA trial' }, admin.token);
    have += units;
  }
  const me = await (await fetch(API + '/v1/me', { headers: { authorization: `Bearer ${team.token}` } })).json();
  console.log(`team account ${email}: ${me.creditsAvailable} credits`);
}
