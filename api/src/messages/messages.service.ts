import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateMessageDto } from './dto/create-message.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Message } from './entities/message.entity';
import { Repository } from 'typeorm';
import { FilterMessageDto } from './dto/filter-message.dto';

@Injectable()
export class MessagesService {

  constructor(
    @InjectRepository( Message )
    private readonly messageRepository: Repository<Message>
  ){}

  async create(createMessageDto: CreateMessageDto, sent = true) {
    const message = this.messageRepository.create({ ...createMessageDto, sent })
    return await this.messageRepository.save(message);
  }

  async findAll(paginationDto: FilterMessageDto) {
    const page = paginationDto.page || 1;
    const limit = paginationDto.limit ?? 10;
    const filter = paginationDto.filter || '';
    const session = paginationDto.session || null;

    const query = this.messageRepository
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.session', 'session');

    if (filter) {
      query.andWhere(
        '(m.message ILIKE :filtro OR session.nameSession ILIKE :filtro)',
        { filtro: `%${filter}%` }
      );
    }

    if (session) {
      query.andWhere('session.id = :sessionId', { sessionId: session });
    }

    const total = await query.getCount();

    if (limit > 0) {
      query.skip((page - 1) * limit).take(limit);
    }

    const data = await query
      .orderBy('m.created_at', 'DESC')
      .getMany();

    return {
      data,
      meta: {
        total,
        page,
        lastPage: limit > 0 ? Math.ceil(total / limit) : 1,
      },
    };
  }

  async findOne(id: string) {
    const message = await this.messageRepository.findOneBy({ id });

    if (!message)
      throw new BadRequestException(`No se encontró el mensaje con el id ${ id }`)

    return message;
  }

  async remove(id: string) {
    const result = await this.messageRepository.softDelete(id);

    if (result.affected === 0) {
      throw new NotFoundException(`Message con ID ${id} no encontrada`);
    }

    return `Message con #${id} removida`;
  }
}
