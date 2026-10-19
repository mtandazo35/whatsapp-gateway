import { IsNotEmpty, IsString, MaxLength } from 'class-validator'

export class SendMessageDto {
  @IsNotEmpty({ message: 'Debes adjuntar el id de la sesión' })
  @IsString({ message: 'El campo sessionId debe ser un string' })
  @MaxLength(64)
  sessionId: string

  @IsNotEmpty({ message: 'Debes adjuntar el número' })
  @IsString({ message: 'El campo number debe ser un string' })
  @MaxLength(32)
  number: string;

  @IsNotEmpty({ message: 'Debes adjuntar el mensaje' })
  @IsString({ message: 'El campo message debe ser un string' })
  @MaxLength(4096)
  message: string
}
