import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Message } from './entities/message.entity';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { FilterMessageDto } from './dto/filter-message.dto';
import { Session } from 'src/session/entities/session.entity';
import { isUUID } from 'class-validator';
import { AuthUser, isAdmin } from 'src/user/interfaces/auth-user.interface';

export interface NewQueuedMessage {
  session: Session;
  message: string;
  receptor: string;
}

/** Transiciones que los ACK de WhatsApp pueden aplicar; nunca se baja de nivel. */
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  pending: 0,
  failed: 1,
  error: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  played: 5,
};

@Injectable()
export class MessagesService {

  constructor(
    @InjectRepository( Message )
    private readonly messageRepository: Repository<Message>
  ){}

  private baseQuery(): SelectQueryBuilder<Message> {
    return this.messageRepository
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.session', 'session')
      .leftJoin('session.owner', 'owner')
      .addSelect(['owner.id']);
  }

  /** Se crea ANTES de encolar: el id del mensaje viaja en el job y es lo que el cliente consulta. */
  async createQueued(input: NewQueuedMessage): Promise<Message> {
    const message = this.messageRepository.create({
      session: input.session,
      message: input.message,
      receptor: input.receptor,
      sent: false,
      status: 'queued',
    })
    return await this.messageRepository.save(message);
  }

  async markSent(id: string, waMessageId?: string): Promise<void> {
    await this.messageRepository.update(id, {
      sent: true,
      status: 'sent',
      waMessageId: waMessageId ?? null,
      lastError: null,
    })
  }

  async markFailed(id: string, error: unknown): Promise<void> {
    const texto = error instanceof Error ? error.message : String(error ?? 'error desconocido')
    await this.messageRepository.update(id, {
      sent: false,
      status: 'failed',
      lastError: texto.slice(0, 500),
    })
  }

  /**
   * Aplica un ACK de WhatsApp solo si avanza el estado (read no vuelve a sent)
   * y solo sobre mensajes de esa sesión.
   */
  async applyAck(sessionId: string, waMessageId: string, status: string): Promise<boolean> {
    const rank = STATUS_RANK[status]
    if (rank === undefined) return false

    const menores = Object.entries(STATUS_RANK)
      .filter(([, r]) => r < rank)
      .map(([s]) => s)

    if (menores.length === 0) return false

    const result = await this.messageRepository
      .createQueryBuilder()
      .update(Message)
      .set({ status, sent: rank >= STATUS_RANK.sent })
      .where('wa_message_id = :waMessageId', { waMessageId })
      .andWhere('status IN (:...menores)', { menores })
      .andWhere('session_id IN (SELECT id FROM sessions WHERE "sessionId" = :sessionId)', { sessionId })
      .execute()

    return (result.affected ?? 0) > 0
  }

  async findAll(paginationDto: FilterMessageDto, actor: AuthUser) {
    const page = paginationDto.page || 1;
    const limit = Math.min(paginationDto.limit || 10, 200);
    const filter = paginationDto.filter || '';
    const session = paginationDto.session || null;

    const query = this.baseQuery();

    if (!isAdmin(actor)) {
      query.andWhere('owner.id = :uid', { uid: actor.id });
    }

    if (filter) {
      query.andWhere(
        '(m.message ILIKE :filtro OR session.nameSession ILIKE :filtro)',
        { filtro: `%${filter}%` }
      );
    }

    // El frontend y las integraciones usan el sessionId corto; la BD relaciona por UUID.
    if (session) {
      if (isUUID(session)) {
        query.andWhere('session.id = :sessionUuid', { sessionUuid: session });
      } else {
        query.andWhere('session.sessionId = :sessionShort', { sessionShort: session });
      }
    }

    const total = await query.getCount();

    const data = await query
      .orderBy('m.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return {
      data,
      meta: {
        total,
        page,
        lastPage: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string, actor: AuthUser) {
    const message = await this.baseQuery()
      .where('m.id = :id', { id })
      .getOne();

    if (!message)
      throw new NotFoundException(`No se encontró el mensaje con el id ${ id }`)

    if (!isAdmin(actor) && message.session?.owner?.id !== actor.id)
      throw new NotFoundException(`No se encontró el mensaje con el id ${ id }`)

    return message;
  }

  async remove(id: string, actor: AuthUser) {
    await this.findOne(id, actor);

    const result = await this.messageRepository.softDelete(id);

    if (result.affected === 0) {
      throw new NotFoundException(`Mensaje con ID ${id} no encontrado`);
    }

    return `Mensaje con #${id} removido`;
  }
}
