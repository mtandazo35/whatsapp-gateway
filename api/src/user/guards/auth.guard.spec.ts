import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { Rol } from '../dto/create-user.dto';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

function contextoCon(authorization?: string): ExecutionContext {
  const request: any = { headers: authorization ? { authorization } : {} };
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
    _request: request,
  } as any;
}

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let jwt: { verifyAsync: jest.Mock };
  let reflector: { getAllAndOverride: jest.Mock };
  let repo: { findOne: jest.Mock };

  const usuarioActivo = {
    id: 'u1',
    email: 'a@b.c',
    usuario: 'ana',
    rol: Rol.USUARIO,
    isActive: true,
  };

  beforeEach(() => {
    jwt = { verifyAsync: jest.fn() };
    reflector = { getAllAndOverride: jest.fn() };
    repo = { findOne: jest.fn() };
    guard = new AuthGuard(
      jwt as any,
      reflector as unknown as Reflector,
      repo as any,
    );
    process.env.JWT_SECRET = 'x'.repeat(32);
    delete process.env.AUTH_DISABLED;
  });

  afterAll(() => {
    delete process.env.AUTH_DISABLED;
  });

  function metadata(opts: { publica?: boolean; roles?: Rol[] }) {
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === IS_PUBLIC_KEY) return opts.publica ?? false;
      if (key === ROLES_KEY) return opts.roles;
      return undefined;
    });
  }

  it('deja pasar rutas @Public() sin token', async () => {
    metadata({ publica: true });
    await expect(guard.canActivate(contextoCon())).resolves.toBe(true);
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('401 sin token', async () => {
    metadata({});
    await expect(guard.canActivate(contextoCon())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('401 con token inválido', async () => {
    metadata({});
    jwt.verifyAsync.mockRejectedValue(new Error('bad'));
    await expect(
      guard.canActivate(contextoCon('Bearer malo')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401 si el usuario del token ya no existe', async () => {
    metadata({});
    jwt.verifyAsync.mockResolvedValue({ id: 'u1' });
    repo.findOne.mockResolvedValue(null);
    await expect(
      guard.canActivate(contextoCon('Bearer ok')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401 si el usuario fue desactivado (revoca tokens anteriores)', async () => {
    metadata({});
    jwt.verifyAsync.mockResolvedValue({ id: 'u1' });
    repo.findOne.mockResolvedValue({ ...usuarioActivo, isActive: false });
    await expect(
      guard.canActivate(contextoCon('Bearer ok')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('deja pasar y adjunta request.user sin contraseña', async () => {
    metadata({});
    jwt.verifyAsync.mockResolvedValue({ id: 'u1' });
    repo.findOne.mockResolvedValue({ ...usuarioActivo, password: 'hash' });
    const ctx = contextoCon('Bearer ok');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const user = (ctx as any)._request.user;
    expect(user.id).toBe('u1');
    expect(user.password).toBeUndefined();
  });

  it('403 si el rol no está en @Roles()', async () => {
    metadata({ roles: [Rol.ADMIN, Rol.SUPER_ADMIN] });
    jwt.verifyAsync.mockResolvedValue({ id: 'u1' });
    repo.findOne.mockResolvedValue(usuarioActivo);
    await expect(
      guard.canActivate(contextoCon('Bearer ok')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('AUTH_DISABLED=true', () => {
    const admin = {
      id: 'adm',
      email: 'admin@x.y',
      usuario: 'admin',
      rol: Rol.SUPER_ADMIN,
      isActive: true,
      password: 'hash',
    };

    beforeEach(() => {
      process.env.AUTH_DISABLED = 'true';
    });

    it('sin token actúa como el SUPER_ADMIN activo (sin contraseña)', async () => {
      metadata({ roles: [Rol.ADMIN, Rol.SUPER_ADMIN] });
      repo.findOne.mockResolvedValue(admin);
      const ctx = contextoCon();
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      const user = (ctx as any)._request.user;
      expect(user.id).toBe('adm');
      expect(user.rol).toBe(Rol.SUPER_ADMIN);
      expect(user.password).toBeUndefined();
      expect(jwt.verifyAsync).not.toHaveBeenCalled();
    });

    it('cachea el admin: dos peticiones, una consulta', async () => {
      metadata({});
      repo.findOne.mockResolvedValue(admin);
      await guard.canActivate(contextoCon());
      await guard.canActivate(contextoCon());
      expect(repo.findOne).toHaveBeenCalledTimes(1);
    });

    it('401 si no queda ningún SUPER_ADMIN activo', async () => {
      metadata({});
      repo.findOne.mockResolvedValue(null);
      await expect(guard.canActivate(contextoCon())).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('con token sigue validando el token (usuario del token, no el admin)', async () => {
      metadata({});
      jwt.verifyAsync.mockResolvedValue({ id: 'u1' });
      repo.findOne.mockResolvedValue(usuarioActivo);
      const ctx = contextoCon('Bearer ok');
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect((ctx as any)._request.user.id).toBe('u1');
    });

    it('con token inválido responde 401 aunque el modo esté activo', async () => {
      metadata({});
      jwt.verifyAsync.mockRejectedValue(new Error('bad'));
      await expect(
        guard.canActivate(contextoCon('Bearer malo')),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  it('pasa si el rol está en @Roles()', async () => {
    metadata({ roles: [Rol.ADMIN] });
    jwt.verifyAsync.mockResolvedValue({ id: 'u1' });
    repo.findOne.mockResolvedValue({ ...usuarioActivo, rol: Rol.ADMIN });
    await expect(guard.canActivate(contextoCon('Bearer ok'))).resolves.toBe(
      true,
    );
  });
});
