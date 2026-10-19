import { BadRequestException } from '@nestjs/common'
import { assertSafeUrl, isPrivateAddress } from './url-guard'

describe('url-guard', () => {
  describe('isPrivateAddress', () => {
    it.each([
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    ])('bloquea %s', (ip) => {
      expect(isPrivateAddress(ip)).toBe(true)
    })

    it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
      'permite %s', (ip) => {
        expect(isPrivateAddress(ip)).toBe(false)
      })

    it('trata lo que no es IP como privado', () => {
      expect(isPrivateAddress('no-es-ip')).toBe(true)
    })
  })

  describe('assertSafeUrl', () => {
    it.each([
      'ftp://example.com/a.pdf',
      'file:///etc/passwd',
      'http://user:pass@example.com/a.pdf',
      'http://localhost/a.pdf',
      'http://api.localhost/a.pdf',
      'http://redis.internal/a.pdf',
      'http://127.0.0.1:6379/',
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'no es una url',
    ])('rechaza %s', async (url) => {
      await expect(assertSafeUrl(url)).rejects.toBeInstanceOf(BadRequestException)
    })

    it('acepta una IP pública literal sin resolver DNS', async () => {
      const url = await assertSafeUrl('https://1.1.1.1/archivo.pdf')
      expect(url.hostname).toBe('1.1.1.1')
    })
  })
})
