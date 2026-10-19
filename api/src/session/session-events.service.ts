import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

/**
 * Bus mínimo en proceso para que el CRUD de sesiones (módulo session) avise al
 * módulo whatsapp sin importarlo (evitaría una dependencia circular).
 * Eventos: 'deactivated' y 'deleted', ambos con el sessionId corto.
 */
@Injectable()
export class SessionEventsService {
  private readonly emitter = new EventEmitter();

  emitDeactivated(sessionId: string) { this.emitter.emit('deactivated', sessionId); }
  emitDeleted(sessionId: string) { this.emitter.emit('deleted', sessionId); }

  onDeactivated(cb: (sessionId: string) => void) { this.emitter.on('deactivated', cb); }
  onDeleted(cb: (sessionId: string) => void) { this.emitter.on('deleted', cb); }
}
