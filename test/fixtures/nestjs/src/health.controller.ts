import { Controller, Get, Head } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { ok: true };
  }

  @Head('health')
  headHealth() {
    return;
  }
}

@Controller(['legacy', 'v0'])
export class LegacyController {
  @Get('ping')
  ping() {
    return 'pong';
  }
}
