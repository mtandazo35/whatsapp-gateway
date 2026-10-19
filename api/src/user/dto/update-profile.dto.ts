import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateUserDto } from './create-user.dto';

/**
 * Lo que un usuario puede cambiar de si mismo: email, contraseña, nombre, celular.
 * Nunca el rol ni isActive (eso es de administradores, via UpdateUserDto).
 */
export class UpdateProfileDto extends PartialType(OmitType(CreateUserDto, ['rol'] as const)) {}
