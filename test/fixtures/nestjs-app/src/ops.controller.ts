import { Controller, Get, Post, VERSION_NEUTRAL } from '@nestjs/common';

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  @Get()
  check() {
    return { ok: true };
  }
}

@Controller('metrics')
export class MetricsController {
  @Get()
  read() {
    return '';
  }

  @Post()
  push() {
    return '';
  }
}
