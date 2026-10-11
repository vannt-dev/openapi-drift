// A test file: its decorators must not count as routes.
import { Controller, Get } from '@nestjs/common';

@Controller('test-only')
export class TestOnlyController {
  @Get('never')
  never() {
    return null;
  }
}
