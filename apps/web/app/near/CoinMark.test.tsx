// @vitest-environment happy-dom
// Which coin it is, exactly: the logo with its network, the contract and its explorer page, the line under the amount to
// send, also for a swap a browser saved before coins had names and logos.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoinMark, ContractLink, sendOnlyText, TokenFacts } from './CoinMark';

const ARB = { id: 'arb', name: 'Arbitrum' };
/** USDT on Arbitrum as a swap saved before this list remembers it: no name, note, logo or native flag. */
const OLD = { assetId: 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near', symbol: 'USDT', decimals: 6, price: 1, contract: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9' };

describe('a coin, exactly', () => {
  it('shows the coin logo with its network at the corner, and none on a network’s own coin at home', () => {
    const usdt = renderToStaticMarkup(<CoinMark coin={OLD} chain={ARB} />);
    expect(usdt).toContain('src="/coins/usdt.svg"');
    expect(usdt).toContain('src="/chains/arb.svg"');
    const eth = renderToStaticMarkup(<CoinMark coin={{ symbol: 'ETH', logo: 'eth.svg', native: true }} chain={{ id: 'eth', name: 'Ethereum' }} />);
    expect(eth).not.toContain('/chains/');
    const ethOnArb = renderToStaticMarkup(<CoinMark coin={{ symbol: 'ETH', logo: 'eth.svg', native: true }} chain={ARB} />);
    expect(ethOnArb).toContain('src="/chains/arb.svg"');
  });

  it('names the coin in full, its contract with a copy button, and its page on the explorer in a new tab', () => {
    const html = renderToStaticMarkup(<TokenFacts coin={OLD} chain={ARB} withSymbol />);
    expect(html).toContain('USDT · Tether USD · USD₮0');
    expect(html).toContain('0xfd08…cbb9');
    expect(html).toContain('href="https://arbiscan.io/token/0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('View on Arbiscan');
  });

  it('offers no contract to copy beside a deposit address: only its name and its page', () => {
    const html = renderToStaticMarkup(<TokenFacts coin={OLD} chain={ARB} withSymbol copyable={false} />);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('0xfd08…cbb9');
    expect(html).toContain('Token contract');
    expect(html).toContain('href="https://arbiscan.io/token/0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"');
    const link = renderToStaticMarkup(<ContractLink coin={OLD} chain={ARB} />);
    expect(link).toContain('Token contract');
    expect(link).not.toContain('0xfd08…cbb9');
    expect(link).toContain('View on Arbiscan');
  });

  it('calls a network’s own coin native, with no contract to open', () => {
    const html = renderToStaticMarkup(<TokenFacts coin={{ symbol: 'NEAR', name: 'NEAR', contract: 'wrap.near', native: true }} chain={{ id: 'near', name: 'NEAR' }} />);
    expect(html).toContain('Native coin of NEAR');
    expect(html).not.toContain('<a');
  });

  it('says plainly which coin on which network to send, with the same contract link', () => {
    expect(sendOnlyText(OLD, ARB)).toBe('Send only USDT on Arbitrum');
    expect(sendOnlyText(OLD, ARB, true)).toBe('More, only USDT on Arbitrum');
    const link = renderToStaticMarkup(<ContractLink coin={OLD} chain={ARB} />);
    expect(link).toContain('href="https://arbiscan.io/token/0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(renderToStaticMarkup(<ContractLink coin={{ symbol: 'BTC', contract: null, native: true }} chain={{ id: 'btc', name: 'Bitcoin' }} />)).toBe('');
  });
});
