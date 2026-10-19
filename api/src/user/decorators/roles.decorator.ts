import { SetMetadata } from '@nestjs/common';
import { Rol } from '../dto/create-user.dto';

export const ROLES_KEY = 'roles';

/** Restringe una ruta a los roles indicados. Sin este decorador basta con estar autenticado. */
export const Roles = (...roles: Rol[]) => SetMetadata(ROLES_KEY, roles);
