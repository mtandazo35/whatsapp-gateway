import { Controller, Get, Param, Delete, Query, ParseUUIDPipe } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { FilterMessageDto } from './dto/filter-message.dto';
import { GetUser, Roles } from 'src/user/decorators';
import { AuthUser } from 'src/user/interfaces/auth-user.interface';
import { Rol } from 'src/user/dto/create-user.dto';

/**
 * Solo lectura desde fuera: los mensajes los crea el gateway al encolar un envío.
 * Un usuario normal solo ve mensajes de sus propias sesiones.
 */
@Controller('messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get()
  findAll(@Query() paginationDto: FilterMessageDto, @GetUser() actor: AuthUser) {
    return this.messagesService.findAll(paginationDto, actor);
  }

  /** Estado de un envío: queued, sent, delivered, read, failed (con lastError). */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @GetUser() actor: AuthUser) {
    return this.messagesService.findOne(id, actor);
  }

  @Roles(Rol.ADMIN, Rol.SUPER_ADMIN)
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @GetUser() actor: AuthUser) {
    return this.messagesService.remove(id, actor);
  }
}
