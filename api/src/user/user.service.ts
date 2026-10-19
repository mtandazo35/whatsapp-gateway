import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateUserDto, Rol } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { PaginationDto } from 'src/common';
import { isEmail, isStrongPassword } from 'class-validator';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { LoginUserDto } from './dto/login-user.dto';
import { AuthUser } from './interfaces/auth-user.interface';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class UserService implements OnModuleInit {

  private readonly logger = new Logger(UserService.name)

  constructor(
    @InjectRepository( User )
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService
  ){}

  /**
   * Primer arranque: si no hay usuarios y ADMIN_EMAIL/ADMIN_PASSWORD estan en el
   * entorno, crea el SUPER_ADMIN inicial. Sin esto nadie podria entrar, porque el
   * alta de usuarios exige estar autenticado como administrador.
   */
  async onModuleInit() {
    try {
      const total = await this.userRepository.count({ withDeleted: true })
      if (total > 0) return

      const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
      const password = process.env.ADMIN_PASSWORD

      if (!email || !password) {
        this.logger.warn('No hay usuarios y faltan ADMIN_EMAIL / ADMIN_PASSWORD: nadie podrá iniciar sesión')
        return
      }

      // El login valida el correo con IsEmail: si el de la semilla no pasa (p. ej.
      // admin@1.2.3.4), el usuario se crearía pero nunca podría entrar.
      if (!isEmail(email)) {
        this.logger.error(`ADMIN_EMAIL "${email}" no es un correo válido; no se crea el administrador inicial`)
        return
      }
      if (!isStrongPassword(password)) {
        this.logger.error('ADMIN_PASSWORD no cumple la política (8+, mayúscula, minúscula, número y símbolo); no se crea el administrador inicial')
        return
      }

      await this.userRepository.save(this.userRepository.create({
        email,
        usuario: 'admin',
        rol: Rol.SUPER_ADMIN,
        password: await bcrypt.hash(password, BCRYPT_ROUNDS),
      }))
      this.logger.log(`Usuario SUPER_ADMIN inicial creado: ${email}`)
    } catch (error) {
      this.logger.error(`No se pudo crear el administrador inicial: ${error?.message}`)
    }
  }

  async signJWT(payload: JwtPayload) {
    return this.jwtService.sign(payload)
  }

  async login(user: LoginUserDto) {
    const userFound = await this.userRepository.findOne({
      where: { email: user.email.trim().toLowerCase() }
    });

    // Mismo mensaje exista o no el usuario, para no revelar correos registrados.
    const credencialesMalas = new UnauthorizedException('Usuario o contraseña incorrectos')

    if (!userFound) throw credencialesMalas

    const ok = await bcrypt.compare(user.password.trim(), userFound.password)
    if (!ok) throw credencialesMalas

    if (!userFound.isActive) {
      throw new UnauthorizedException('Usuario desactivado')
    }

    const { password: _, ...restUser } = userFound;

    return {
      ...restUser,
      token: await this.signJWT({ id: userFound.id })
    }
  }

  /** Solo SUPER_ADMIN puede otorgar SUPER_ADMIN; ADMIN puede dar ADMIN o USUARIO. */
  private assertCanAssignRole(actor: AuthUser, rol: Rol | undefined) {
    if (rol === Rol.SUPER_ADMIN && actor.rol !== Rol.SUPER_ADMIN) {
      throw new ForbiddenException('Solo un SUPER_ADMIN puede asignar el rol SUPER_ADMIN')
    }
  }

  /** Un ADMIN no puede tocar a un SUPER_ADMIN. */
  private assertCanManage(actor: AuthUser, target: User) {
    if (target.rol === Rol.SUPER_ADMIN && actor.rol !== Rol.SUPER_ADMIN) {
      throw new ForbiddenException('No puedes modificar a un SUPER_ADMIN')
    }
  }

  async create(createUserDto: CreateUserDto, actor: AuthUser) {
    this.assertCanAssignRole(actor, createUserDto.rol)

    try {
      const userCreate = this.userRepository.create({
        ...createUserDto,
        email: createUserDto.email.trim().toLowerCase(),
        rol: createUserDto.rol ?? Rol.USUARIO,
        password: await bcrypt.hash(createUserDto.password, BCRYPT_ROUNDS),
      })

      const user = await this.userRepository.save(userCreate)
      const { password: _, ...rest } = user;

      // El alta la hace un administrador: no se devuelve token del usuario creado.
      return rest
    } catch (error) {
      if (error.message?.includes('duplicate key value violates unique constraint')) {
        throw new BadRequestException(`Ya existe un usuario con este email ${ createUserDto.email }`)
      }

      throw new BadRequestException(error.message)
    }
  }

  async findAll(paginationDto: PaginationDto) {
    const page = paginationDto.page || 1;
    const limit = Math.min(paginationDto.limit || 10, 100);

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
      throw new NotFoundException(`No se encontró al usuario con el id ${ id }`)

    const { password: _, ...rest } = user;
    return rest;
  }

  async update(id: string, updateUserDto: UpdateUserDto, actor: AuthUser) {
    const target = await this.userRepository.findOneBy({ id });
    if (!target)
      throw new NotFoundException(`No se encontró al usuario con el id ${ id }`)

    this.assertCanManage(actor, target)
    this.assertCanAssignRole(actor, updateUserDto.rol)

    if (id === actor.id && (updateUserDto.isActive === false || (updateUserDto.rol && updateUserDto.rol !== actor.rol))) {
      throw new BadRequestException('No puedes desactivarte ni cambiar tu propio rol')
    }

    try {
      const cambios: Partial<User> = { ...updateUserDto }

      if (updateUserDto.password)
        cambios.password = await bcrypt.hash(updateUserDto.password, BCRYPT_ROUNDS)

      if (updateUserDto.email)
        cambios.email = updateUserDto.email.trim().toLowerCase()

      await this.userRepository.update(id, cambios);

      return `Registro editado`;
    } catch (error) {
      if (error.message?.includes('duplicate key value violates unique constraint')) {
        throw new BadRequestException(`Ya existe un usuario con este email ${ updateUserDto.email }`)
      }

      throw new BadRequestException(error.message)
    }
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    try {
      const cambios: Partial<User> = { ...dto }

      if (dto.password)
        cambios.password = await bcrypt.hash(dto.password, BCRYPT_ROUNDS)

      if (dto.email)
        cambios.email = dto.email.trim().toLowerCase()

      await this.userRepository.update(userId, cambios);
      return this.findOne(userId)
    } catch (error) {
      if (error.message?.includes('duplicate key value violates unique constraint')) {
        throw new BadRequestException(`Ya existe un usuario con este email ${ dto.email }`)
      }

      throw new BadRequestException(error.message)
    }
  }

  async remove(id: string, actor: AuthUser) {
    if (id === actor.id) {
      throw new BadRequestException('No puedes eliminar tu propio usuario')
    }

    const target = await this.userRepository.findOneBy({ id });
    if (!target) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
    }
    this.assertCanManage(actor, target)

    const result = await this.userRepository.softDelete(id);

    if (result.affected === 0) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
    }

    return `Usuario con #${id} removido`;
  }

  async restore(id: string): Promise<void> {
    const result = await this.userRepository.restore(id);

    if (result.affected === 0) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado o no estaba eliminado`);
    }
  }
}
