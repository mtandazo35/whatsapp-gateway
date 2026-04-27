import { IsNotEmpty, IsOptional, IsString, IsUUID } from "class-validator";
import { Session } from "src/session/entities/session.entity";

export class CreateMessageDto {

  @IsNotEmpty({ message: 'Debes enviar el id de la sesion' })
  @IsUUID()
  session: Session;

  @IsNotEmpty({ message: 'Debes enviar un mensaje' })
  @IsString({ message: 'Debes enviar un mensaje valido' })
  message: string;

  @IsOptional()
  @IsString()
  receptor: string;

}
