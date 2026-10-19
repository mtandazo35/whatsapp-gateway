import { Rol } from '../dto/create-user.dto';

/** Lo que el AuthGuard deja en `request.user`: nunca incluye la contraseña. */
export interface AuthUser {
  id: string;
  email: string;
  usuario: string;
  rol: Rol;
  isActive: boolean;
}

export function isAdmin(user: Pick<AuthUser, 'rol'> | null | undefined): boolean {
  return !!user && (user.rol === Rol.ADMIN || user.rol === Rol.SUPER_ADMIN);
}
