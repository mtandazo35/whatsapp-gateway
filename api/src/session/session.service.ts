import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Session } from './entities/session.entity';
import { Like, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { PaginationDto } from 'src/common';
import { isUUID } from 'class-validator';

@Injectable()
export class SessionService {

  constructor(
    @InjectRepository( Session )
    private readonly sesionRepository: Repository<Session>
  ){}

  async create(createSessionDto: CreateSessionDto) {
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
      sessionId
    });

    return await this.sesionRepository.save(sessionCreate);
  }

  async findAll(paginationDto: PaginationDto) {
    try {
      const page = paginationDto.page || 1;
      const limit = paginationDto.limit ?? 10;
      const filter = paginationDto.filter || '';

      const query = this.sesionRepository.createQueryBuilder('s');

      if (filter) {
        query.andWhere(
          '(s.nameSession ILIKE :filtro OR s.numberSession ILIKE :filtro OR s.sessionId ILIKE :filtro)',
          { filtro: `%${filter}%` }
        );
      }

      const total = await query.getCount();

      if (limit > 0) {
        query.skip((page - 1) * limit).take(limit);
      }

      const data = await query.orderBy('s.created_at', 'DESC').getMany();

      return {
        data,
        meta: {
          total,
          page,
          lastPage: limit > 0 ? Math.ceil(total / limit) : 1,
        },
      };

    } catch (error) {
      console.log(error)
    }
  }

  async findOne(id: string) {

    let session;
    if (isUUID(id)) {
      session = await this.sesionRepository.findOneBy({ id });
    } else {
      session = await this.sesionRepository.findOneBy({ sessionId: id });
    }

    if (!session)
      throw new BadRequestException(`No se encontró la sesión con el id ${ id }`)

    return session;
  }

  async findSession(sessionId: string) {
    return await this.sesionRepository.findOneBy({ sessionId });
  }

  async update(id: string, updateSessionDto: UpdateSessionDto) {
    try {
      await this.findOne(id as unknown as string);

      await this.sesionRepository.update(id, updateSessionDto);

      return `Registro editado`;
    } catch (error) {
      throw new BadRequestException(error.message)
    }
  }

  async remove(id: string) {
    const result = await this.sesionRepository.softDelete(id);

    if (result.affected === 0) {
      throw new NotFoundException(`Session con ID ${id} no encontrada`);
    }

    return `Session con #${id} removida`;
  }

  async restore(id: string): Promise<void> {
    const result = await this.sesionRepository.restore(id);

    if (result.affected === 0) {
      throw new NotFoundException(`Session con ID ${id} no encontrada o no estaba eliminada`);
    }
  }
}
