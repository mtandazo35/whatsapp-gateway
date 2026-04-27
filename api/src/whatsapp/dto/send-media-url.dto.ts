import { IntersectionType, PartialType } from '@nestjs/mapped-types'
import { IsNotEmpty, IsUrl } from 'class-validator'
import { SendMediaDto } from './send-media.dto'

class MediaUrlOnly {
  @IsUrl({}, { message: 'Debes una url valida' })
  @IsNotEmpty({ message: 'Debes enviar el campo mediaUrl' })
  mediaUrl: string;
}

export class SendMediaUrlDto extends IntersectionType(SendMediaDto, MediaUrlOnly) {}
