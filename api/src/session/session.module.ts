import { Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { Session } from './entities/session.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionEventsService } from './session-events.service';

@Module({
  controllers: [SessionController],
  providers: [SessionService, SessionEventsService],
  imports: [
    TypeOrmModule.forFeature([ Session ]),
  ],
  exports: [
    SessionService,
    SessionEventsService,
    TypeOrmModule
  ]
})
export class SessionModule {}
