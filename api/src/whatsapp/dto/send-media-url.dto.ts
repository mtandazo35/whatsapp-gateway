import { IntersectionType } from '@nestjs/mapped-types'
import { IsNotEmpty, IsUrl, MaxLength } from 'class-validator'
import { SendMediaDto } from './send-media.dto'

class MediaUrlOnly {
  // IsUrl valida la forma; el destino (redes internas, redirecciones, tamaño)
  // lo valida assertSafeUrl + probeMediaUrl en el servicio.
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { message: 'Debes enviar una URL http(s) válida' })
  @IsNotEmpty({ message: 'Debes enviar el campo mediaUrl' })
  @MaxLength(2048)
  mediaUrl: string;
}

export class SendMediaUrlDto extends IntersectionType(SendMediaDto, MediaUrlOnly) {}
