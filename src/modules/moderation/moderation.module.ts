import { Module } from '@nestjs/common';
import {
  EscalationController,
  FlagsController,
  ModerationController,
} from './moderation.controller';
import { ModerationService } from './moderation.service';

@Module({
  controllers: [FlagsController, EscalationController, ModerationController],
  providers: [ModerationService],
})
export class ModerationModule {}
