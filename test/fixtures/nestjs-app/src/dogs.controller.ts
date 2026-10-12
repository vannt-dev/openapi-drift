import { Controller, Get, Version } from '@nestjs/common';

@Controller({ path: 'dogs', version: ['2', '3'] })
export class DogsController {
  @Get()
  list() {
    return [];
  }

  @Version('4')
  @Get('legacy')
  legacy() {
    return [];
  }
}
