import { IsOptional, IsString, MaxLength } from "class-validator";
import { PaginationDto } from "src/common";

export class FilterMessageDto extends PaginationDto {

  /** UUID de la sesión o su sessionId corto; ambos valen. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  session?: string

}
