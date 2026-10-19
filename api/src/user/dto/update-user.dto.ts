import { PartialType } from '@nestjs/mapped-types';
import { CreateUserDto } from './create-user.dto';
import { IsBoolean, IsOptional } from 'class-validator';

/** Edicion administrativa: incluye rol e isActive. Solo ADMIN / SUPER_ADMIN. */
export class UpdateUserDto extends PartialType(CreateUserDto) {

  @IsOptional()
  @IsBoolean()
  isActive?: boolean

}
