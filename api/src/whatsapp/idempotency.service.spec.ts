import { decidir, hashPayload, IDEM_PENDING_MS } from './idempotency.service'

describe('idempotencia', () => {
  it('el hash no depende del orden de las claves', () => {
    expect(hashPayload({ a: 1, b: 'x' })).toBe(hashPayload({ b: 'x', a: 1 }))
  })

  it('cuerpos distintos dan hashes distintos', () => {
    expect(hashPayload({ number: '1', message: 'hola' })).not.toBe(hashPayload({ number: '1', message: 'adios' }))
  })

  it('sin registro -> new', () => {
    expect(decidir(null, 'h')).toEqual({ status: 'new' })
  })

  it('misma clave con otro cuerpo -> conflict', () => {
    expect(decidir({ state: 'done', hash: 'h1', at: 0, response: {} }, 'h2')).toEqual({ status: 'conflict' })
    expect(decidir({ state: 'pending', hash: 'h1', at: Date.now() }, 'h2')).toEqual({ status: 'conflict' })
  })

  it('terminada con el mismo cuerpo -> done con la respuesta original', () => {
    const resp = { status: 'queued', messageId: 'm1' }
    expect(decidir({ state: 'done', hash: 'h', at: 0, response: resp }, 'h')).toEqual({ status: 'done', response: resp })
  })

  it('pendiente reciente -> pending; pendiente abandonada -> se reclama', () => {
    const ahora = Date.now()
    expect(decidir({ state: 'pending', hash: 'h', at: ahora - 1000 }, 'h', ahora)).toEqual({ status: 'pending' })
    expect(decidir({ state: 'pending', hash: 'h', at: ahora - IDEM_PENDING_MS - 1 }, 'h', ahora)).toBe('reclamar')
  })
})
