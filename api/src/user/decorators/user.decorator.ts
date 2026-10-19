import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import { AuthUser } from '../interfaces/auth-user.interface';

/** Devuelve el usuario autenticado que dejó el AuthGuard en la request. */
export const GetUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();

    if (!request.user) {
      throw new InternalServerErrorException('Usuario no encontrado en la request');
    }

    return request.user;
  },
);
