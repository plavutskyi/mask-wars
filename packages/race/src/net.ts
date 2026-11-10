// The network a job runs on (MASKWARS_NETWORK, packages/network) and a guard on the accounts it is handed: a variable
// left over from testnet on a mainnet run, or the other way round, stops the job before it signs or reads anything.
import { NET, onNetwork } from "@maskwars/network";

/** `account`, if it belongs to the network this job runs on; otherwise an error that names the variable. */
export function onThisNetwork(what: string, account: string): string {
  if (!onNetwork(NET.id, account)) throw new Error(`${what}: ${account} is not a ${NET.id} account (MASKWARS_NETWORK=${NET.id})`);
  return account;
}

/** The arena's own masks by name: MASK_ACCOUNTS when it is set, else the network's own (packages/network `masks`). */
export function maskAccounts(json: string | undefined): Record<string, string> {
  const accounts = json ? (JSON.parse(json) as Record<string, string>) : { ...NET.masks };
  for (const [name, account] of Object.entries(accounts)) onThisNetwork(`MASK_ACCOUNTS.${name}`, account);
  return accounts;
}
