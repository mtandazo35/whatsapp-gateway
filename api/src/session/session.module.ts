import { Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { Session } from './entities/session.entity';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  controllers: [SessionController],
  providers: [SessionService],
  imports: [
    TypeOrmModule.forFeature([ Session ]),
  ],
  exports: [
    SessionService,
    TypeOrmModule
  ]
})
export class SessionModule {}
