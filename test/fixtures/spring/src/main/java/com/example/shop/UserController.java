package com.example.shop;

import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

// @GetMapping("/from-a-comment") must not count
@RestController
@RequestMapping("/api/users")
public class UserController {

    private static final String USERS_EXPORT = "/export";

    @GetMapping
    public List<UserDto> list(@RequestParam int page,
                              @RequestParam(name = "size", required = false) Integer pageSize,
                              @RequestParam(value = "q", defaultValue = "") String query) {
        return List.of();
    }

    @GetMapping("/{id}")
    public UserDto one(@PathVariable UUID id) {
        return null;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public UserDto create(@Valid @RequestBody CreateUser body) {
        return null;
    }

    @PutMapping(value = "/{id}", consumes = "application/json")
    public ResponseEntity<UserDto> replace(@PathVariable UUID id, @RequestBody UserDto body) {
        return ResponseEntity.ok(body);
    }

    @DeleteMapping("/{id:[0-9a-f-]{36}}")
    public ResponseEntity<Void> remove(@PathVariable String id) {
        if (id.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.noContent().build();
    }

    /* @PostMapping("/in-a-block-comment") must not count either */
    @RequestMapping(path = {"/search", "/find"}, method = {RequestMethod.GET, RequestMethod.POST})
    public List<UserDto> search(SearchCriteria criteria) {
        return List.of();
    }

    @GetMapping(USERS_EXPORT)
    public String export(@RequestParam Map<String, String> filters) {
        return "";
    }
}
