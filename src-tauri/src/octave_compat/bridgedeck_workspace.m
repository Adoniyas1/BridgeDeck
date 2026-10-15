function bridgedeck_workspace(names)
  % BridgeDeck: writes the program's variables (name, size, class, a short value) to workspace.tsv.
  fid = fopen('workspace.tsv', 'w');
  if fid < 0, return; end
  for k = 1:min(numel(names), 200)
    n = names{k};
    if strncmp(n, 'bridgedeck_', 11), continue; end
    try
      v = evalin('caller', n);
    catch
      continue;
    end
    s = '';
    try
      if (isnumeric(v) || islogical(v)) && numel(v) <= 100
        s = mat2str(v, 5);
      elseif ischar(v) && size(v, 1) <= 1
        s = ['''' v ''''];
      elseif iscellstr(v) && numel(v) <= 20
        s = ['{' strjoin(cellfun(@(x) ['''' x ''''], v(:)', 'UniformOutput', false), ', ') '}'];
      elseif isstruct(v)
        s = ['fields: ' strjoin(fieldnames(v)', ', ')];
      elseif isa(v, 'function_handle')
        s = func2str(v);
      elseif isnumeric(v)
        s = sprintf('min %g, max %g', min(v(:)), max(v(:)));
      end
    catch
      s = '';
    end
    s = strrep(strrep(s, sprintf('\t'), ' '), sprintf('\n'), ' ');
    if numel(s) > 300, s = [s(1:300) '…']; end
    dims = strjoin(arrayfun(@num2str, size(v), 'UniformOutput', false), 'x');
    fprintf(fid, '%s\t%s\t%s\t%s\n', n, dims, class(v), s);
  end
  fclose(fid);
end
