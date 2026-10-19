import { IsEmail, IsNotEmpty, IsString, MaxLength } from "class-validator";

export class LoginUserDto {

  @IsNotEmpty()
  @IsEmail()
  email: string;

  // En el login no se valida la fortaleza: eso es cosa del alta. Aqui solo
  // importa que venga algo razonable para comparar con el hash.
  @IsNotEmpty()
  @IsString()
  @MaxLength(128)
  password: string;

}
