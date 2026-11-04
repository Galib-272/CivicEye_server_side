import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiEnvelopeResponse, ApiErrorResponses } from '../common/http/openapi';
import { LivenessDto, ReadinessDto } from './health.dto';
import { HealthService } from './health.service';

@ApiTags('health')
@SkipThrottle()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness: the process is running. Does not check dependencies.' })
  @ApiEnvelopeResponse(LivenessDto)
  live(): LivenessDto {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: the API can reach PostgreSQL and Redis.' })
  @ApiEnvelopeResponse(ReadinessDto)
  @ApiErrorResponses(503)
  async ready(): Promise<ReadinessDto> {
    const report = await this.health.readiness();
    if (!report.ready) {
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        undefined,
        Object.entries(report.checks).map(([component, status]) => ({
          message: `${component} is ${status}`,
          component,
          status,
        })),
      );
    }
    return { status: 'ok', checks: report.checks };
  }
}
