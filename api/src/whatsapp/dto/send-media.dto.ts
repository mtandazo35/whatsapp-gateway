import { IsNotEmpty, IsString, IsOptional, MaxLength } from 'class-validator'

export class SendMediaDto {
  @IsNotEmpty({ message: 'Debes adjuntar el id de la sesión' })
  @IsString({ message: 'El campo sessionId debe ser un string' })
  @MaxLength(64)
  sessionId: string

  @IsNotEmpty({ message: 'Debes adjuntar el número' })
  @IsString({ message: 'El campo number debe ser un string' })
  @MaxLength(32)
  number: string;

  @IsOptional()
  @IsString({ message: 'El campo caption debe ser un string' })
  @MaxLength(1024)
  caption?: string
}
