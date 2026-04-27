import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, IsStrongPassword, MinLength } from "class-validator";

export enum Rol {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  USUARIO = 'USUARIO'
}

export class CreateUserDto {
  @IsNotEmpty()
  @IsEmail({}, { message: 'Debes ingresar un email valido' })
  email: string;

  @IsNotEmpty()
  @IsStrongPassword({}, { message: "La contraseña no es lo suficientemente segura." })
  password: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(5)
  usuario: string;

  @IsOptional()
  @IsString()
  celular: string;

  @IsOptional()
  @IsEnum(Rol, {
    message: `El rol debe ser uno de: ${Object.values(Rol).join(', ')}`
  })
  rol: Rol;
}
