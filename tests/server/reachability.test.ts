import { describe, expect, it } from 'vitest';
import { classifyPublicUrl, isPrivateAddress } from '../../server/tasksync/reachability';

// D19: which PUBLIC_URL a cloud task service could post webhooks to.
describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', true], ['127.8.9.10', true], ['::1', true], ['0.0.0.0', true], ['::', true],
    ['10.0.0.1', true], ['10.255.255.255', true],
    ['172.16.0.1', true], ['172.31.255.254', true], ['172.15.0.1', false], ['172.32.0.1', false],
    ['192.168.1.20', true], ['192.169.0.1', false],
    ['100.64.0.1', true], ['100.101.1.2', true], ['100.127.255.254', true], ['100.63.255.255', false], ['100.128.0.1', false],
    ['169.254.10.1', true],
    ['fc00::1', true], ['fd12:3456::1', true], ['fe80::1', true], ['febf::1', true], ['fec0::1', false],
    ['::ffff:10.0.0.1', true], ['::ffff:8.8.8.8', false],
    ['8.8.8.8', false], ['93.184.216.34', false], ['2606:4700::1', false], ['2001:4860:4860::8888', false],
  ])('%s is private: %s', (ip, want) => { expect(isPrivateAddress(ip)).toBe(want); });
});

describe('classifyPublicUrl', () => {
  const to = (...ips: string[]) => async () => ips;
  it('needs a PUBLIC_URL', async () => {
    expect(await classifyPublicUrl(undefined, to('8.8.8.8'))).toMatchObject({ https: false, publicAddress: false, reason: 'PUBLIC_URL is not set' });
  });
  it('reads https from the scheme and the address from DNS', async () => {
    expect(await classifyPublicUrl('https://opsmap.example.com', to('93.184.216.34'))).toEqual({ https: true, publicAddress: true });
    expect(await classifyPublicUrl('http://opsmap.example.com', to('93.184.216.34'))).toMatchObject({ https: false, publicAddress: true });
    expect(await classifyPublicUrl('https://opsmap.example.com', to('93.184.216.34', '10.0.0.5'))).toMatchObject({ https: true, publicAddress: false, reason: 'PUBLIC_URL is a private address (10.0.0.5)' });
  });
  it('a tailnet name that resolves to 100.x is private', async () => {
    expect(await classifyPublicUrl('https://opsmap.ribbon.ts.net', to('100.101.1.2'))).toMatchObject({ https: true, publicAddress: false, reason: expect.stringContaining('.ts.net') });
    expect(await classifyPublicUrl('https://ops.example.com', to('100.101.1.2'))).toMatchObject({ publicAddress: false, reason: 'PUBLIC_URL is a private address (100.101.1.2)' });
  });
  it.each(['http://opsmap.local', 'http://opsmap.lan', 'https://opsmap.internal', 'https://opsmap.home.arpa', 'https://box.tail1234.ts.net'])('%s is a private name', async url => {
    expect(await classifyPublicUrl(url, to('93.184.216.34'))).toMatchObject({ publicAddress: false, reason: expect.stringMatching(/^PUBLIC_URL is a private name/) });
  });
  it('loopback, literal addresses and names that do not resolve', async () => {
    expect(await classifyPublicUrl('http://127.0.0.1:8080', to())).toMatchObject({ publicAddress: false, loopback: true });
    expect(await classifyPublicUrl('http://localhost:8080', to('127.0.0.1'))).toMatchObject({ publicAddress: false, loopback: true });
    expect(await classifyPublicUrl('http://[::1]:8080', to())).toMatchObject({ publicAddress: false, loopback: true });
    expect(await classifyPublicUrl('http://192.168.1.20', to())).toMatchObject({ publicAddress: false, reason: 'PUBLIC_URL is a private address (192.168.1.20)' });
    expect(await classifyPublicUrl('https://[2606:4700::1]', to())).toEqual({ https: true, publicAddress: true });
    expect(await classifyPublicUrl('https://nowhere.example', async () => { throw new Error('ENOTFOUND'); })).toMatchObject({ publicAddress: false, failed: true, reason: 'PUBLIC_URL nowhere.example does not resolve' });
  });
});
