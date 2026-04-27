import { IsNotEmpty, IsString } from 'class-validator'

export class SendMessageDto {
  @IsNotEmpty({ message: 'Debes adjuntar el id de la sesión' })
  @IsString({ message: 'el campo sessionId debe ser un string' })
  sessionId: string

  @IsNotEmpty({ message: 'Debes adjuntar el numero' })
  @IsString({ message: 'El capo number debe ser un string' })
  number: string;

  @IsNotEmpty({ message: 'Debes adjuntar el mensaje' })
  @IsString({ message: 'El campo message debe ser un string' })
  message: string
}
