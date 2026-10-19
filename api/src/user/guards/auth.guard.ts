import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { Rol } from '../dto/create-user.dto';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { AuthUser } from '../interfaces/auth-user.interface';

/**
 * Guard global (APP_GUARD): deniega por defecto.
 * - Rutas con @Public() pasan sin token.
 * - El resto exige Bearer JWT valido Y que el usuario exista y siga activo
 *   (asi desactivar o borrar un usuario invalida sus tokens anteriores).
 * - Si la ruta lleva @Roles(...), el rol del usuario debe estar en la lista.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('Token no enviado');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: process.env.JWT_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    const user = await this.userRepository.findOne({
      where: { id: payload.id },
      select: { id: true, email: true, usuario: true, rol: true, isActive: true },
    });

    if (!user) {
      throw new UnauthorizedException('El usuario del token ya no existe');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('Usuario desactivado');
    }

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      usuario: user.usuario,
      rol: user.rol,
      isActive: user.isActive,
    };
    (request as any).user = authUser;

    const roles = this.reflector.getAllAndOverride<Rol[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles?.length && !roles.includes(authUser.rol)) {
      throw new ForbiddenException('No tienes permisos para esta operación');
    }

    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
