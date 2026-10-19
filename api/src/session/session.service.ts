import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Session } from './entities/session.entity';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { randomUUID } from 'crypto';
import { PaginationDto } from 'src/common';
import { isUUID } from 'class-validator';
import { AuthUser, isAdmin } from 'src/user/interfaces/auth-user.interface';
import { User } from 'src/user/entities/user.entity';
import { SessionEventsService } from './session-events.service';

@Injectable()
export class SessionService {

  constructor(
    @InjectRepository( Session )
    private readonly sesionRepository: Repository<Session>,
    private readonly events: SessionEventsService,
  ){}

  /** Consulta base: trae el dueño solo con id y email (nunca el hash de contraseña). */
  private baseQuery(): SelectQueryBuilder<Session> {
    return this.sesionRepository
      .createQueryBuilder('s')
      .leftJoin('s.owner', 'owner')
      .addSelect(['owner.id', 'owner.email']);
  }

  /** Lanza 403 si el usuario no es admin ni dueño de la sesión. */
  assertAccess(session: Session, actor: AuthUser) {
    if (isAdmin(actor)) return;
    if (session.owner?.id && session.owner.id === actor.id) return;
    throw new ForbiddenException('No tienes acceso a esta sesión');
  }

  async create(createSessionDto: CreateSessionDto, actor: AuthUser) {
    let sessionId: string;
    let isUnique = false;

    while (!isUnique) {
      sessionId = randomUUID().replace(/-/g, '').substring(0, 12);

      const existingSession = await this.sesionRepository.findOne({
        where: { sessionId }
      });

      if (!existingSession) isUnique = true;
    }

    const sessionCreate = this.sesionRepository.create({
      ...createSessionDto,
      sessionId,
      owner: { id: actor.id } as User,
    });

    const saved = await this.sesionRepository.save(sessionCreate);
    return this.findOne(saved.id, actor);
  }

  async findAll(paginationDto: PaginationDto, actor: AuthUser) {
    const page = paginationDto.page || 1;
    const limit = Math.min(paginationDto.limit || 10, 100);
    const filter = paginationDto.filter || '';

    const query = this.baseQuery();

    if (!isAdmin(actor)) {
      query.andWhere('owner.id = :uid', { uid: actor.id });
    }

    if (filter) {
      query.andWhere(
        '(s.nameSession ILIKE :filtro OR s.numberSession ILIKE :filtro OR s.sessionId ILIKE :filtro)',
        { filtro: `%${filter}%` }
      );
    }

    const total = await query.getCount();

    const data = await query
      .orderBy('s.created_at', 'DESC')
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

  /** Busca por UUID o por sessionId corto y comprueba acceso si se pasa actor. */
  async findOne(id: string, actor?: AuthUser) {
    const query = this.baseQuery();

    if (isUUID(id)) {
      query.where('s.id = :id', { id });
    } else {
      query.where('s.sessionId = :sid', { sid: id });
    }

    const session = await query.getOne();

    if (!session)
      throw new NotFoundException(`No se encontró la sesión con el id ${ id }`)

    if (actor) this.assertAccess(session, actor);

    return session;
  }

  /** Por sessionId corto, sin comprobar acceso (uso interno: workers, QR). Devuelve null si no existe. */
  async findSession(sessionId: string): Promise<Session | null> {
    return await this.baseQuery()
      .where('s.sessionId = :sid', { sid: sessionId })
      .getOne();
  }

  /** Por sessionId corto, exigiendo que el actor pueda usarla. */
  async findSessionForUser(sessionId: string, actor: AuthUser): Promise<Session> {
    const session = await this.findSession(sessionId);

    if (!session)
      throw new BadRequestException(`No existe una sesión con el id ${ sessionId }, por favor comunicarte con el administrador`)

    this.assertAccess(session, actor);
    return session;
  }

  /** sessionIds que el actor puede ver: null significa "todas" (admin). */
  async visibleSessionIds(actor: AuthUser): Promise<Set<string> | null> {
    if (isAdmin(actor)) return null;

    const rows = await this.sesionRepository
      .createQueryBuilder('s')
      .select('s.sessionId', 'sessionId')
      .innerJoin('s.owner', 'owner')
      .where('owner.id = :uid', { uid: actor.id })
      .getRawMany<{ sessionId: string }>();

    return new Set(rows.map(r => r.sessionId));
  }

  async update(id: string, updateSessionDto: UpdateSessionDto, actor: AuthUser) {
    const session = await this.findOne(id, actor);

    await this.sesionRepository.update(session.id, updateSessionDto);

    // Desactivar debe parar la sesión de verdad: socket, jobs en cola y credenciales.
    if (updateSessionDto.isActive === false && session.isActive) {
      this.events.emitDeactivated(session.sessionId);
    }

    return `Registro editado`;
  }

  async remove(id: string, actor: AuthUser) {
    const session = await this.findOne(id, actor);

    const result = await this.sesionRepository.softDelete(session.id);

    if (result.affected === 0) {
      throw new NotFoundException(`Sesión con ID ${id} no encontrada`);
    }

    this.events.emitDeleted(session.sessionId);

    return `Sesión con #${id} removida`;
  }

  async restore(id: string, actor: AuthUser): Promise<void> {
    const session = await this.sesionRepository.findOne({
      where: { id },
      withDeleted: true,
      relations: { owner: true },
      select: { id: true, deleted_at: true, owner: { id: true } },
    });

    if (!session || !session.deleted_at) {
      throw new NotFoundException(`Sesión con ID ${id} no encontrada o no estaba eliminada`);
    }

    this.assertAccess(session as Session, actor);

    await this.sesionRepository.restore(id);
  }
}
