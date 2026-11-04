import { ApiProperty } from '@nestjs/swagger';

export class LivenessDto {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';
}

export class ReadinessChecksDto {
  @ApiProperty({ enum: ['up', 'down'] })
  database!: 'up' | 'down';

  @ApiProperty({ enum: ['up', 'down'] })
  redis!: 'up' | 'down';
}

export class ReadinessDto {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';

  @ApiProperty({ type: ReadinessChecksDto })
  checks!: ReadinessChecksDto;
}
