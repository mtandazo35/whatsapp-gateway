import { IsNotEmpty, IsString, IsUrl, IsOptional } from 'class-validator'

export class SendMediaDto {
  @IsNotEmpty({ message: 'Debes adjuntar el id de la sesión' })
  @IsString({ message: 'el campo sessionId debe ser un string' })
  sessionId: string

  @IsNotEmpty({ message: 'Debes adjuntar el numero' })
  @IsString({ message: 'El capo number debe ser un string' })
  number: string;

  @IsOptional()
  @IsString({ message: 'el campo sessionId debe ser un string' })
  caption?: string
}
