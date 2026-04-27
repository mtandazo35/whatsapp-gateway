import { Type } from 'class-transformer';
import { IsOptional, IsPositive, IsString, Min } from 'class-validator';

export class PaginationDto {

  @IsPositive()
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @Min(0)
  @IsOptional()
  @Type(() => Number)
  limit?: number = 10;

  @IsString()
  @IsOptional()
  filter?: string;

}