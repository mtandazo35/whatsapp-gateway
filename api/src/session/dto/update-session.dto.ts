import { PartialType } from '@nestjs/mapped-types';
import { CreateSessionDto } from './create-session.dto';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateSessionDto extends PartialType(CreateSessionDto) {

  @IsOptional()
  @IsBoolean()
  isActive?: boolean

}
