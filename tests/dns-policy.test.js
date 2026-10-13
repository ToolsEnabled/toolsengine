import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicAddress } from '../src/web.js';

test('public IPv4 remains allowed while private and mapped IPv6 addresses are refused', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '104.20.23.154', '172.66.147.243', '2606:4700:4700::1111', '2001:4860:4860::8888'])
    assert.doesNotThrow(() => assertPublicAddress(ip), ip);
  for (const ip of ['0.0.0.0', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '198.18.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8'])
    assert.throws(() => assertPublicAddress(ip), { code: 'LOCAL_NETWORK_BLOCKED' }, ip);
});
