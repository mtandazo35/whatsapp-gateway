import { BadRequestException } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { Rol } from 'src/user/dto/create-user.dto';

/**
 * Lo que se prueba: antes de encolar, el controlador comprueba con WhatsApp que el
 * destinatario existe. Un número incompleto no debe quedar como "enviado".
 */
describe('WhatsappController (número destino)', () => {
  const actor = {
    id: 'u1',
    email: 'a@b.c',
    usuario: 'ana',
    rol: Rol.ADMIN,
    isActive: true,
  };
  const session = { sessionId: 's1', isActive: true };

  let whatsapp: {
    checkIfNumberExists: jest.Mock;
    sendMessage: jest.Mock;
    retry: jest.Mock;
  };
  let sessions: { findSessionForUser: jest.Mock };
  let messages: { findOne: jest.Mock };
  let ctrl: WhatsappController;

  beforeEach(() => {
    whatsapp = {
      checkIfNumberExists: jest.fn(),
      sendMessage: jest.fn().mockResolvedValue({
        messageId: 'm1',
        jobId: 'm1',
      }),
      retry: jest.fn().mockResolvedValue({ messageId: 'm2', jobId: 'm2' }),
    };
    sessions = { findSessionForUser: jest.fn().mockResolvedValue(session) };
    messages = { findOne: jest.fn() };
    ctrl = new WhatsappController(
      whatsapp as any,
      sessions as any,
      messages as any,
      {} as any,
    );
  });

  const dto = { sessionId: 's1', number: '5939426672', message: 'hola' } as any;

  it('400 y nada encolado si el número no tiene WhatsApp', async () => {
    whatsapp.checkIfNumberExists.mockResolvedValue({
      exists: false,
      jid: null,
    });
    await expect(
      ctrl.sendMessage(dto, undefined, false, actor as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  it('encola si el número existe', async () => {
    whatsapp.checkIfNumberExists.mockResolvedValue({
      exists: true,
      jid: '5939426672@s.whatsapp.net',
    });
    const r = await ctrl.sendMessage(dto, undefined, false, actor as any);
    expect(r).toMatchObject({ status: 'queued', messageId: 'm1' });
    expect(whatsapp.sendMessage).toHaveBeenCalledWith(
      session,
      '5939426672',
      'hola',
      false,
      'u1',
    );
  });

  it('si la comprobación falla (no es un "no existe"), deja pasar y encola', async () => {
    whatsapp.checkIfNumberExists.mockResolvedValue({
      exists: false,
      error: 'Error verificando el número en WhatsApp',
    });
    const r = await ctrl.sendMessage(dto, undefined, false, actor as any);
    expect(r).toMatchObject({ status: 'queued' });
  });

  it('el reintento también comprueba el número', async () => {
    messages.findOne.mockResolvedValue({
      id: 'm0',
      receptor: '5939426672',
      session: { sessionId: 's1' },
    });
    whatsapp.checkIfNumberExists.mockResolvedValue({
      exists: false,
      jid: null,
    });
    await expect(
      ctrl.retry('0b1f0000-0000-4000-8000-000000000000', actor as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(whatsapp.retry).not.toHaveBeenCalled();
  });
});
