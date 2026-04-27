import { Transform } from "class-transformer";
import { IsNotEmpty, IsString } from "class-validator";

export class CreateSessionDto {

  @IsNotEmpty({ message: 'Debes enviar un nombre de sesión' })
  @IsString()
  @Transform(
    ({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
    { toClassOnly: true }
  )
  nameSession: string;

}
