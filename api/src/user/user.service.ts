import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { PaginationDto } from 'src/common';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { LoginUserDto } from './dto/login-user.dto';

@Injectable()
export class UserService {

  constructor(
    @InjectRepository( User )
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService
  ){}

  async signJWT(payload: JwtPayload) {
    return this.jwtService.sign(payload)
  }

  async login(user: LoginUserDto) {
    try {

      const userFound = await this.userRepository.findOne({
        where: { email: user.email }
      });

      if (!userFound) {
        throw new Error('Usuario o contraseña incorrectos')
      }

      if ( !bcrypt.compareSync( user.password.trim(), userFound.password) )
        throw new UnauthorizedException('Usuario o contraseña incorrectos')

      const {
        password,
        ...restUser
      } = userFound;

      return {
        ...restUser,
        token: await this.signJWT({
          id: userFound.id
        })
      }

    } catch (error) {
      throw new BadRequestException(error.message)
    }
  }

  async create(createUserDto: CreateUserDto) {
    try {

      const userCreate = this.userRepository.create({
        ...createUserDto,
        password: bcrypt.hashSync( createUserDto.password, 10 ),
      })

      const user =  await this.userRepository.save(userCreate)
      const { password: _, ...rest } = user;

      return {
        user: rest,
        token: await this.signJWT({
          id: rest.id
        })
      }
    } catch (error) {
      if (error.message.includes('duplicate key value violates unique constraint')) {
        throw new BadRequestException(`Ya existe un usuario con este email ${ createUserDto.email }`)
      }

      throw new BadRequestException(error.message)
    }
  }

  async findAll(paginationDto: PaginationDto) {
    const page = paginationDto.page || 1;
    const limit = paginationDto.limit || 10;

    const totalPages = await this.userRepository.count();
    const lastPage = Math.ceil(totalPages / limit);

    const data = await this.userRepository.find({
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        celular: true,
        email: true,
        usuario: true,
        rol: true,
        isActive: true,
        created_at: true,
        updated_at: true
      },
      order: { created_at: 'DESC' }
    })

    return {
      data,
      meta: {
        total: totalPages,
        page: page,
        lastPage: lastPage,
      },
    };
  }

  async findOne(id: string) {
    const user = await this.userRepository.findOneBy({ id });

    if (!user)
      throw new BadRequestException(`No se encontró al usuario con el id ${ id }`)

    const { password: _, ...rest } = user;
    return rest;
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    try {
      await this.findOne(id as unknown as string);

      if ( updateUserDto.password )
        updateUserDto.password = bcrypt.hashSync( updateUserDto.password, 10 )

      await this.userRepository.update(id, updateUserDto);

      return `Registro editado`;
    } catch (error) {
      if (error.message.includes('duplicate key value violates unique constraint')) {
        throw new BadRequestException(`Ya existe un usuario con este email ${ updateUserDto.email }`)
      }

      throw new BadRequestException(error.message)
    }
  }

  async remove(id: string) {
    const result = await this.userRepository.softDelete(id);

    if (result.affected === 0) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrada`);
    }

    return `Usuario con #${id} removida`;
  }

  async restore(id: string): Promise<void> {
    const result = await this.userRepository.restore(id);

    if (result.affected === 0) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrada o no estaba eliminada`);
    }
  }
}
