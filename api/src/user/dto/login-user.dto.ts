import { IsEmail, IsNotEmpty, IsStrongPassword } from "class-validator";

export class LoginUserDto {

  @IsNotEmpty()
  @IsEmail()
  email: string;

  @IsNotEmpty()
  @IsStrongPassword({}, { message: "La contraseña no es lo suficientemente segura." })
  password: string;

}
