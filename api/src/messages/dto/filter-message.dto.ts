import { IsOptional } from "class-validator";
import { PaginationDto } from "src/common";

export class FilterMessageDto extends PaginationDto {

  @IsOptional()
  session: string | null

}

