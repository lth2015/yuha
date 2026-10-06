import solc from 'solc';
import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync('tests/fixtures/evm/MockToken.sol', 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'MockToken.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    /*
     * Paris, not the solc default.
     *
     * Current solc emits PUSH0, which the local EVM used by the tests does not
     * implement; the deployment then consumes exactly its gas limit and
     * reverts — a signature that reads like "needs more gas" and is not. The
     * mainnet contracts this stands in for are not affected either way, since
     * nothing here is deployed anywhere real.
     */
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join('\n')); process.exit(1); }
const c = out.contracts['MockToken.sol'].MockToken;
writeFileSync(
  'tests/fixtures/evm/MockToken.json',
  JSON.stringify({
    _comment: 'Compiled from MockToken.sol with solc. Regenerate with scripts/compile-mock-token.mjs.',
    solcVersion: solc.version(),
    evmVersion: 'paris',
    abi: c.abi,
    bytecode: `0x${c.evm.bytecode.object}`,
  }, null, 2) + '\n',
);
console.log('compiled with', solc.version(), '-', c.evm.bytecode.object.length / 2, 'bytes');
