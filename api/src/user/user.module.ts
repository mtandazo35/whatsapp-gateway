import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { User } from './entities/user.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { AuthGuard } from './guards/auth.guard';

@Module({
  controllers: [UserController],
  providers: [
    UserService,
    // Guard global: toda ruta exige token salvo las marcadas con @Public().
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  imports: [
    ConfigModule.forRoot(),
    TypeOrmModule.forFeature([ User ]),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      // jsonwebtoken tipa expiresIn como StringValue ('8h', '1d'...) y no acepta string plano.
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '8h') as any },
    }),
  ],
  exports: [TypeOrmModule]
})
export class UserModule {}
