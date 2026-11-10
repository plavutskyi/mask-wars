// Where the site forges masks, and whether the forge is open: the factory answers from the chain and its mask code is
// published. Until then nothing on the site points at /forge. The network is the site's (MASKWARS_NETWORK).
import { type FactoryConfig, type Network, view } from '@maskwars/forge';
import { NET, onNetwork, yocto } from '@maskwars/network';

// A factory named by hand counts only on its own network: a testnet name left in the settings of a mainnet build
// would send a person's wallet to an account that does not exist there.
const namedFactory = process.env.NEXT_PUBLIC_FORGE_FACTORY;

export const FORGE_NET: Network = {
  id: NET.id,
  explorer: NET.explorer,
  factory: namedFactory && onNetwork(NET.id, namedFactory) ? namedFactory : NET.factory,
  rpcs: process.env.NEXT_PUBLIC_FORGE_RPC ? process.env.NEXT_PUBLIC_FORGE_RPC.split(',') : NET.rpc,
};

/** The most a person may put into a mask on this network, in whole NEAR (limits.fuel_max of packages/network). */
export const FUEL_MAX = Number(yocto(NET.limits.fuel_max) / 10n ** 24n);

/** The forge takes a mask only once the factory has published the mask code (`contracts/masks/factory`, `forge`). */
export async function forgeOpen(net: Network = FORGE_NET, timeoutMs = 4000): Promise<boolean> {
  try {
    const cfg = await view<FactoryConfig>(net, 'config', {}, timeoutMs);
    return cfg.mask_code.published === true;
  } catch {
    return false;
  }
}
