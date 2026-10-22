# Stablecoin RPC verification mode

`STABLECOIN_RPC_MODE` defaults to `dual`. In that mode Chainstack (primary)
and BlockPI (secondary) are both queried for chain ID, finality, headers,
receipts, transactions, token decimals and transfer logs. A failure from either
provider stops the scan; it is not an automatic failover.

`single_secondary` is an explicit temporary degradation: **only BlockPI is
queried**, including for both transfer discovery and payment confirmation.
The primary URL remains configured but is not contacted. The worker emits a
warning on startup. `agreed` in internal results does not imply independent
corroboration in this mode. A bad or incomplete BlockPI response can cause a
payment to be missed or misattributed, so this mode must be monitored closely.

Set the same value in both `qa-music-api-config` and `qa-music-worker-config`,
then restart both deployments after publishing code that supports the mode.
Keep `STABLECOIN_USDC_ENABLED=false` until the scanner advances and a small
real payment has been reconciled against an independent block explorer.
Check worker scan errors and the cursor before opening a new currency.

To restore independent verification, fix or replace the primary RPC, probe its
historical `eth_getLogs` and finalized-block support, set both ConfigMaps back
to `dual`, and restart both deployments. Do not point both URLs at the same
endpoint: two labels on one provider are not two independent witnesses.
