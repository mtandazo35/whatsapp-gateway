import { Controller, Get, Post, Body, Patch, Param, Delete, Query, ParseUUIDPipe, Put } from '@nestjs/common';
import { UserService } from './user.service';
import { CreateUserDto, Rol } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { PaginationDto } from 'src/common';
import { LoginUserDto } from './dto/login-user.dto';
import { GetUser, Public, Roles } from './decorators';
import { AuthUser } from './interfaces/auth-user.interface';
import { ThrottleLogin } from 'src/common/rate-limit';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Public()
  @ThrottleLogin()
  @Post('/login')
  login(@Body() user: LoginUserDto) {
    return this.userService.login(user);
  }

  // ---- perfil propio (cualquier usuario autenticado) ----

  @Get('/me')
  me(@GetUser() user: AuthUser) {
    return this.userService.findOne(user.id);
  }

  @Patch('/me')
  updateMe(@GetUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.userService.updateProfile(user.id, dto);
  }

  // ---- administracion de usuarios ----

  @Roles(Rol.ADMIN, Rol.SUPER_ADMIN)
  @Post()
  create(@Body() createUserDto: CreateUserDto, @GetUser() actor: AuthUser) {
    return this.userService.create(createUserDto, actor);
  }

  @Roles(Rol.ADMIN, Rol.SUPER_ADMIN)
  @Get()
  findAll(@Query() paginationDto: PaginationDto) {
    return this.userService.findAll(paginationDto);
  }

  @Roles(Rol.ADMIN, Rol.SUPER_ADMIN)
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.userService.findOne(id);
  }

  @Roles(Rol.ADMIN, Rol.SUPER_ADMIN)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
    @GetUser() actor: AuthUser,
  ) {
    return this.userService.update(id, updateUserDto, actor);
  }

  @Roles(Rol.ADMIN, Rol.SUPER_ADMIN)
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @GetUser() actor: AuthUser) {
    return this.userService.remove(id, actor);
  }

  @Roles(Rol.ADMIN, Rol.SUPER_ADMIN)
  @Put('/restore/:id')
  restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.userService.restore(id);
  }
}
