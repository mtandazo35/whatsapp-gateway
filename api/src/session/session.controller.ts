import { Controller, Get, Post, Body, Patch, Param, Delete, Query, ParseUUIDPipe, Put } from '@nestjs/common';
import { SessionService } from './session.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { PaginationDto } from 'src/common';
import { GetUser } from 'src/user/decorators';
import { AuthUser } from 'src/user/interfaces/auth-user.interface';

/**
 * Todas las rutas exigen token (guard global). Un usuario normal solo ve y
 * modifica las sesiones de las que es dueño; ADMIN y SUPER_ADMIN ven todas.
 */
@Controller('session')
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  @Post()
  create(@Body() createSessionDto: CreateSessionDto, @GetUser() actor: AuthUser) {
    return this.sessionService.create(createSessionDto, actor);
  }

  @Get()
  findAll(@Query() paginationDto: PaginationDto, @GetUser() actor: AuthUser) {
    return this.sessionService.findAll(paginationDto, actor);
  }

  /** Acepta UUID o sessionId corto. */
  @Get(':id')
  findOne(@Param('id') id: string, @GetUser() actor: AuthUser) {
    return this.sessionService.findOne(id, actor);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateSessionDto: UpdateSessionDto,
    @GetUser() actor: AuthUser,
  ) {
    return this.sessionService.update(id, updateSessionDto, actor);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @GetUser() actor: AuthUser) {
    return this.sessionService.remove(id, actor);
  }

  @Put('/restore/:id')
  restore(@Param('id', ParseUUIDPipe) id: string, @GetUser() actor: AuthUser) {
    return this.sessionService.restore(id, actor);
  }
}
